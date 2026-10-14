import { describe, expect, it } from "vitest";
import { TaskLifecycle } from "../src/lifecycle";
import { agent, base, candidateSha, claimInput, create, db, fenced as sharedFenced, human, intent, key, life, retainSources, source, submitted } from "./lifecycle-fixture";
async function fenced(id: string) {
    const targetRef = `refs/heads/governance-${id}`;
    await db.prepare("INSERT INTO target_refs VALUES(?,?,?,?,?)")
        .bind("canonical", targetRef, base, new Date().toISOString(), "seed").run();
    const records = await sharedFenced(id, undefined, targetRef);
    expect(await life.one("SELECT repository_id,ref_name,status FROM canonical_fences WHERE fence_id=?", records.landing.body.fenceId))
        .toEqual({ repository_id: "canonical", ref_name: targetRef, status: "held" });
    return records;
}
const state = (expectedStatus: string, expectedIntentVersion = 1) => ({ expectedStatus, expectedIntentVersion });
const refusal = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ code });
async function auditCount(id: string) { return (await life.rows("SELECT id FROM audit_log WHERE task_id=?", id)).length; }
async function approval(id: string) {
    return life.approve(id, human, key(`approve-${id}`), { boundTo: { candidateSha, baseSha: base, intentVersion: 1 } });
}
async function atStatus(id: string, status: string) {
    if (["candidate", "approved"].includes(status)) {
        const result = await submitted(id);
        if (status === "approved")
            await approval(id);
        return result.claim;
    }
    await life.create(id, human, key(`create-${id}`), { ...intent, projectId: "p", repositoryId: "canonical", targetRef: "refs/heads/main", key: id });
    if (status === "draft")
        return undefined;
    await life.publish(id, human, key(`publish-${id}`));
    if (status === "ready")
        return undefined;
    const claim = `claim-${id}`;
    await life.claim(id, key(claim), claimInput(claim));
    await life.provision(claim);
    if (status === "submitted")
        await life.submit(id, agent, claim, key(`submit-${id}`), { sourceSha: source, baseSha: base, intentVersion: 1 });
    return claim;
}
async function followup(id: string) {
    const first = await fenced(id);
    const staged = await life.submit(id, agent, first.claim, key(`followup-${id}`), { sourceSha: source, baseSha: base, intentVersion: 1 });
    await life.reconcile(id, key(`reconcile-${id}`), { fenceId: first.landing.body.fenceId, runId: first.landing.body.runId,
        outcome: "landed", canonicalSha: candidateSha, landedSha: candidateSha, ancestryVerified: true, writerTerminated: true, eventIds: [] });
    const job = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute' AND json_extract(payload,'$.submissionId')=?", id, staged.body.id);
    const candidate = await life.candidate(id, key(`followup-result-${id}`), { runId: job.run_id, submissionId: staged.body.id,
        candidateId: `candidate-${job.run_id}`, candidateSha: source, baseSha: candidateSha,
        candidateRef: `refs/candidates/candidate-${job.run_id}`, checkIdentity: "none", checkPolicy: { mode: "none" } });
    return { candidate, receipt: first.landing.body.receiptId };
}
describe("governance transitions", () => {
    it("unpublishes ready atomically, replays without another audit and refuses stale/nonhuman/state changes", async () => {
        await create("unpublish");
        await refusal(life.makeUnready("unpublish", agent, key("agent-unpublish"), state("ready")), "human-required");
        await refusal(life.makeUnready("unpublish", human, key("stale-unpublish"), state("ready", 2)), "expected-state-mismatch");
        const result = await life.makeUnready("unpublish", human, key("unpublish-command"), state("ready"));
        const count = await auditCount("unpublish");
        expect(await life.makeUnready("unpublish", human, key("unpublish-command"), state("ready"))).toEqual(result);
        expect(await auditCount("unpublish")).toBe(count);
        await refusal(life.makeUnready("unpublish", human, key("unpublish-command"), state("draft")), "idempotency-conflict");
        await life.reevaluate("unpublish", key("unpublished-reevaluate"));
        expect(await life.task("unpublish")).toMatchObject({ status: "draft", published_at: null });
        await refusal(life.makeUnready("unpublish", human, key("second-unpublish"), state("draft")), "not-ready");
    });
    it("adds/removes dependencies with same-decision admission, edge guards, and transitive/self cycle refusal", async () => {
        for (const id of ["dep-a", "dep-b", "dep-c"])
            await create(id);
        const add = { ...state("ready"), upstreamTaskId: "dep-b", action: "add" as const };
        expect((await life.changeDependency("dep-a", human, key("dep-add-a"), add)).body.status).toBe("draft");
        const count = await auditCount("dep-a");
        await life.changeDependency("dep-a", human, key("dep-add-a"), add);
        expect(await auditCount("dep-a")).toBe(count);
        await refusal(life.changeDependency("dep-a", human, key("duplicate-dep"), { ...add, expectedStatus: "draft" }), "dependency-state-mismatch");
        await life.changeDependency("dep-b", human, key("dep-add-b"), { ...state("ready"), upstreamTaskId: "dep-c", action: "add" });
        await refusal(life.changeDependency("dep-c", human, key("dep-cycle"), { ...state("ready"), upstreamTaskId: "dep-a", action: "add" }), "dependency-cycle");
        await refusal(life.changeDependency("dep-c", human, key("dep-self"), { ...state("ready"), upstreamTaskId: "dep-c", action: "add" }), "dependency-cycle");
        await refusal(life.changeDependency("dep-c", agent, key("dep-agent"), { ...state("ready"), upstreamTaskId: "dep-a", action: "add" }), "human-required");
        await refusal(life.changeDependency("dep-c", human, key("dep-missing"), { ...state("ready"), upstreamTaskId: "missing", action: "add" }), "not-found");
        const remove = { ...state("draft"), upstreamTaskId: "dep-b", action: "remove" as const };
        const removed = await life.changeDependency("dep-a", human, key("dep-remove-a"), remove);
        expect(removed.body.status).toBe("ready");
        expect(await life.changeDependency("dep-a", human, key("dep-remove-a"), remove)).toEqual(removed);
        await refusal(life.changeDependency("dep-a", human, key("dep-remove-absent"), { ...remove, expectedStatus: "ready" }), "dependency-state-mismatch");
        await life.claim("dep-a", key("dep-claim"), claimInput("dep-claim"));
        await refusal(life.changeDependency("dep-a", human, key("claimed-dep"), { ...state("claimed"), upstreamTaskId: "dep-b", action: "add" }), "dependency-edit-refused");
    });
    it("enforces the cycle check at commit for concurrent reciprocal dependency edits", async () => {
        await create("cycle-a");
        await create("cycle-b");
        const concurrent = new TaskLifecycle(db);
        const original = concurrent.one.bind(concurrent);
        let waiting = 0;
        let unblock!: () => void;
        const barrier = new Promise<void>(r => { unblock = r; });
        concurrent.one = async (sql: string, ...params: unknown[]) => {
            const result = await original(sql, ...params);
            if (sql.startsWith("SELECT 1 AS found WHERE EXISTS(WITH RECURSIVE")) {
                if (++waiting === 2)
                    unblock();
                await barrier;
            }
            return result;
        };
        const results = await Promise.allSettled([
            concurrent.changeDependency("cycle-a", human, key("cycle-a-b"), { ...state("ready"), upstreamTaskId: "cycle-b", action: "add" }),
            concurrent.changeDependency("cycle-b", human, key("cycle-b-a"), { ...state("ready"), upstreamTaskId: "cycle-a", action: "add" }),
        ]);
        expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
        expect(results.find(x => x.status === "rejected")).toMatchObject({ status: "rejected", reason: { code: "operation-in-progress", status: 409 } });
        expect(await life.rows("SELECT * FROM task_dependencies WHERE task_id IN ('cycle-a','cycle-b')")).toHaveLength(1);
        expect(await life.rows("SELECT * FROM lifecycle_operations WHERE scope LIKE '%cycle-%:dependency-add'")).toHaveLength(1);
    });
    it("admits an edge added after upstream landing enumerated its dependents", async () => {
        const upstream = await fenced("edge-race-upstream");
        await create("edge-race-dependent");
        const concurrent = new TaskLifecycle(db);
        const original = concurrent.one.bind(concurrent);
        let landed = false;
        concurrent.one = async (sql: string, ...params: unknown[]) => {
            const snapshot = await original(sql, ...params);
            if (!landed && sql === "SELECT * FROM tasks WHERE id=? AND project_id=?" && params[0] === "edge-race-upstream") {
                landed = true;
                await life.reconcile("edge-race-upstream", key("edge-race-land"), {
                    fenceId: upstream.landing.body.fenceId, runId: upstream.landing.body.runId,
                    outcome: "landed", canonicalSha: candidateSha, landedSha: candidateSha,
                    ancestryVerified: true, writerTerminated: true, eventIds: [],
                });
                expect(await life.rows("SELECT task_id FROM task_dependencies WHERE depends_on_task_id=?", "edge-race-upstream")).toEqual([]);
            }
            return snapshot;
        };
        await concurrent.changeDependency("edge-race-dependent", human, key("edge-race-add"), {
            ...state("ready"), upstreamTaskId: "edge-race-upstream", action: "add",
        });
        expect(landed).toBe(true);
        expect(await life.task("edge-race-dependent")).toMatchObject({ status: "draft", published_at: expect.any(String) });
        expect(await life.one("SELECT admissible FROM v_task_admission WHERE task_id=?", "edge-race-dependent")).toEqual({ admissible: 1 });
        expect(await life.rows("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='reevaluate' AND delivered_at IS NULL", "edge-race-dependent")).toHaveLength(1);
        await life.dispatch({ send: async () => { } }, "edge-race-dependent", async (id, command, jobKey) => {
            expect(command).toBe("reevaluate");
            return life.reevaluate(id, jobKey);
        });
        expect((await life.task("edge-race-dependent")).status).toBe("ready");
        expect((await life.claim("edge-race-dependent", key("edge-race-claim"), claimInput("edge-race-claim"))).status).toBe(202);
    });
    for (const status of ["draft", "ready", "claimed", "submitted", "candidate", "approved"]) {
        for (const outcome of ["rejected", "superseded"] as const) {
            it(`closes ${status} as ${outcome}, with separate audits and irreversible terminal state`, async () => {
                const id = `${status}-${outcome}`;
                const claim = await atStatus(id, status);
                const replacementTaskId = outcome === "superseded" ? `${id}-replacement` : undefined;
                if (replacementTaskId)
                    await create(replacementTaskId);
                const input = { ...state(status), outcome, ...(replacementTaskId ? { replacementTaskId } : {}) };
                const before = await auditCount(id);
                const result = await life.closeTask(id, human, key(`close-${id}`), input);
                expect(await life.task(id)).toMatchObject({ status: outcome, closed_at: expect.any(String), superseded_by_task_id: replacementTaskId ?? null });
                if (claim) {
                    expect(await life.one("SELECT status FROM claims WHERE id=?", claim)).toEqual({ status: "revoked" });
                    expect(await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='cleanup'", id)).toBeTruthy();
                    expect(await life.one("SELECT revoked_at FROM claim_broker_grants WHERE claim_id=?", claim)).toEqual({ revoked_at: expect.any(String) });
                }
                const audits = await life.rows("SELECT type,refs FROM audit_log WHERE task_id=? ORDER BY id", id);
                const closure = audits.slice(before).map(a => ({ type: a.type, ...JSON.parse(a.refs) }));
                expect(closure.filter(a => a.entityType === "task")).toHaveLength(1);
                if (["candidate", "approved"].includes(status))
                    expect(closure).toContainEqual(expect.objectContaining({ entityType: "candidate", fromStatus: "active", toStatus: "rejected" }));
                if (status === "approved")
                    expect(closure).toContainEqual(expect.objectContaining({ entityType: "approval", fromStatus: "active", toStatus: "invalidated", reason: "task-closed" }));
                const count = await auditCount(id);
                expect(await life.closeTask(id, human, key(`close-${id}`), input)).toEqual(result);
                expect(await auditCount(id)).toBe(count);
                await refusal(life.closeTask(id, human, key(`reclose-${id}`), { ...state(outcome), outcome: "rejected" }), "task-closed");
            });
        }
    }
    it("refuses unauthorized, stale, invalid replacement, held-fence and landed closure", async () => {
        await create("closure-refusal");
        const input = { ...state("ready"), outcome: "superseded" as const, replacementTaskId: "closure-refusal" };
        await refusal(life.closeTask("closure-refusal", agent, key("agent-close"), input), "human-required");
        await refusal(life.closeTask("closure-refusal", human, key("stale-close"), { ...input, expectedStatus: "draft" }), "expected-state-mismatch");
        await refusal(life.closeTask("closure-refusal", human, key("self-close"), input), "invalid-replacement");
        await refusal(life.closeTask("closure-refusal", human, key("missing-close"), { ...input, replacementTaskId: "missing" }), "invalid-replacement");
        await refusal(life.closeTask("closure-refusal", human, key("malformed-close"), { ...input, replacementTaskId: {} as any }), "invalid-replacement");
        const records = await fenced("closure-fence");
        await refusal(life.closeTask("closure-fence", human, key("fenced-close"), { ...state("landing"), outcome: "rejected" }), "fenced");
        await life.reconcile("closure-fence", key("closed-land"), { fenceId: records.landing.body.fenceId, runId: records.landing.body.runId,
            outcome: "landed", canonicalSha: candidateSha, landedSha: candidateSha, ancestryVerified: true, writerTerminated: true, eventIds: [] });
        await refusal(life.closeTask("closure-fence", human, key("landed-close"), { ...state("landed"), outcome: "rejected" }), "task-closed");
        await life.closeTask("closure-refusal", human, key("landed-replacement"), { ...input, replacementTaskId: "closure-fence" });
        expect(await life.task("closure-fence")).toMatchObject({ status: "landed", accepted_receipt_id: records.landing.body.receiptId });
    });
    it("rolls back coupled transitions and ledger if any later mutation fails", async () => {
        const { claim } = await submitted("closure-rollback");
        await approval("closure-rollback");
        const before = await auditCount("closure-rollback");
        const failing = new TaskLifecycle(db);
        const original = (failing as any).statusTransition.bind(failing);
        (failing as any).statusTransition = (...args: any[]) => {
            const transition = original(...args);
            if (args[3] === "task")
                transition.mutation.params[0] = "bad-status";
            return transition;
        };
        await expect(failing.closeTask("closure-rollback", human, key("rollback-close"), { ...state("approved"), outcome: "rejected" })).rejects.toBeTruthy();
        expect(await life.task("closure-rollback")).toMatchObject({ status: "approved" });
        expect(await life.one("SELECT status FROM claims WHERE id=?", claim)).toEqual({ status: "active" });
        expect(await auditCount("closure-rollback")).toBe(before);
        expect(await life.one("SELECT key FROM lifecycle_operations WHERE key=?", key("rollback-close"))).toBeNull();
    });
    it("replaces a claim atomically, preserves review, revokes old grants and retires mapping after retention", async () => {
        const { claim } = await submitted("takeover");
        await approval("takeover");
        const input = { ...state("approved"), claimId: claim, newClaimId: "takeover-new", expiresAt: new Date(Date.now() + 3600000).toISOString() };
        await refusal(life.replaceClaim("takeover", agent, key("agent-takeover"), input), "human-required");
        await refusal(life.replaceClaim("takeover", human, key("wrong-takeover"), { ...input, claimId: "missing" }), "claim-inactive");
        await refusal(life.replaceClaim("takeover", human, key("expired-takeover"), { ...input, expiresAt: new Date(0).toISOString() }), "invalid-request");
        const result = await life.replaceClaim("takeover", human, key("takeover-command"), input);
        const count = await auditCount("takeover");
        expect(await life.replaceClaim("takeover", human, key("takeover-command"), input)).toEqual(result);
        expect(await auditCount("takeover")).toBe(count);
        expect(await life.one("SELECT status FROM claims WHERE id=?", claim)).toEqual({ status: "superseded" });
        expect(await life.one("SELECT status,actor_type,actor_id FROM claims WHERE id='takeover-new'")).toEqual({ status: "active", actor_type: "human", actor_id: human.id });
        expect((await life.task("takeover")).status).toBe("approved");
        expect((await life.claim("takeover", key("ordinary-takeover"), claimInput("ordinary-takeover"))).body.code).toBe("already-claimed");
        await refusal(life.submit("takeover", agent, claim, key("old-takeover-submit"), { sourceSha: source, baseSha: base, intentVersion: 1 }), "claim-inactive");
        await life.provision("takeover-new");
        await refusal(life.cleanup(claim), "source-custody-pending");
        await retainSources("takeover");
        await life.cleanup(claim);
        expect(await life.one("SELECT retired_at FROM task_repo_mappings WHERE claim_id=?", claim)).toEqual({ retired_at: expect.any(String) });
        const f = await fenced("takeover-fenced");
        await refusal(life.replaceClaim("takeover-fenced", human, key("fenced-takeover"), { ...input, ...state("landing"), claimId: f.claim, newClaimId: "fenced-new" }), "fenced");
    });
    it("takes a new accepted dependency snapshot and refuses terminal replacement", async () => {
        const upstream = await fenced("snapshot-upstream");
        await life.reconcile("snapshot-upstream", key("snapshot-land"), { fenceId: upstream.landing.body.fenceId, runId: upstream.landing.body.runId,
            outcome: "landed", canonicalSha: candidateSha, landedSha: candidateSha, ancestryVerified: true, writerTerminated: true, eventIds: [] });
        await create("snapshot-dependent", ["snapshot-upstream"]);
        await life.claim("snapshot-dependent", key("snapshot-old-claim"), claimInput("snapshot-old"));
        await life.edit("snapshot-dependent", human, key("snapshot-intent"), { ...intent, title: "Revised" });
        const input = { ...state("claimed", 2), claimId: "snapshot-old", newClaimId: "snapshot-new", expiresAt: new Date(Date.now() + 3600000).toISOString() };
        await life.replaceClaim("snapshot-dependent", human, key("snapshot-replace"), input);
        expect(await life.one("SELECT intent_version FROM claims WHERE id='snapshot-new'")).toEqual({ intent_version: 2 });
        expect(await life.rows("SELECT upstream_task_id,receipt_id,landed_sha FROM claim_dependency_results WHERE claim_id='snapshot-new'"))
            .toEqual([{ upstream_task_id: "snapshot-upstream", receipt_id: upstream.landing.body.receiptId, landed_sha: candidateSha }]);
        await refusal(life.replaceClaim("snapshot-upstream", human, key("terminal-replace"), { ...input, ...state("landed") }), "task-closed");
        await create("admission-landed");
        expect((await life.changeDependency("admission-landed", human, key("add-landed-dep"), { ...state("ready"), upstreamTaskId: "snapshot-upstream", action: "add" })).body.status).toBe("ready");
    });
    it("withdraws approval before candidate and enforces claimant ownership, refusal and idempotency", async () => {
        const { candidate } = await submitted("withdraw");
        const a = await approval("withdraw");
        await refusal(life.withdrawCandidate("withdraw", agent, key("approved-withdraw"), { ...state("approved"), candidateId: candidate.body.id }), "approval-active");
        const input = { ...state("approved"), approvalId: a.body.id };
        await refusal(life.withdrawApproval("withdraw", agent, key("agent-approval-withdraw"), input), "human-required");
        const result = await life.withdrawApproval("withdraw", human, key("approval-withdraw"), input);
        const count = await auditCount("withdraw");
        expect(await life.withdrawApproval("withdraw", human, key("approval-withdraw"), input)).toEqual(result);
        expect(await auditCount("withdraw")).toBe(count);
        expect((await life.task("withdraw")).status).toBe("candidate");
        const cInput = { ...state("candidate"), candidateId: candidate.body.id };
        await refusal(life.withdrawCandidate("withdraw", { type: "agent", id: "other" }, key("other-withdraw"), cInput), "forbidden");
        const withdrawn = await life.withdrawCandidate("withdraw", agent, key("candidate-withdraw"), cInput);
        expect((await life.task("withdraw")).status).toBe("submitted");
        const after = await auditCount("withdraw");
        expect(await life.withdrawCandidate("withdraw", agent, key("candidate-withdraw"), cInput)).toEqual(withdrawn);
        expect(await auditCount("withdraw")).toBe(after);
        await refusal(life.withdrawCandidate("withdraw", human, key("inactive-withdraw"), { ...cInput, expectedStatus: "submitted" }), "candidate-inactive");
        await refusal(life.withdrawApproval("withdraw", human, key("inactive-approval"), { ...input, expectedStatus: "submitted" }), "approval-invalidated");
        const f = await fenced("withdraw-fenced");
        await refusal(life.withdrawApproval("withdraw-fenced", human, key("fenced-approval-withdraw"), { ...state("landing"), approvalId: f.approval.body.id }), "fenced");
        await refusal(life.withdrawCandidate("withdraw-fenced", human, key("fenced-candidate-withdraw"), { ...state("landing"), candidateId: f.candidate.body.id }), "fenced");
    });
    it("rejects/withdraws follow-up attempt authority without changing accepted result", async () => {
        const { candidate, receipt } = await followup("followup-rejection");
        const a = await life.approve("followup-rejection", human, key("followup-approve"), { boundTo: { candidateSha: source, baseSha: candidateSha, intentVersion: 1 } });
        const input = { ...state("landed"), candidateId: candidate.body.id };
        await refusal(life.rejectCandidate("followup-rejection", agent, key("agent-followup-reject"), input), "human-required");
        const result = await life.rejectCandidate("followup-rejection", human, key("followup-reject"), input);
        expect(await life.rejectCandidate("followup-rejection", human, key("followup-reject"), input)).toEqual(result);
        expect(await life.task("followup-rejection")).toMatchObject({ status: "landed", accepted_receipt_id: receipt });
        expect(await life.one("SELECT status,invalidation_reason FROM approvals WHERE id=?", a.body.id)).toEqual({ status: "invalidated", invalidation_reason: "task-closed" });
        const follow = await followup("followup-withdrawal");
        const approved = await life.approve("followup-withdrawal", human, key("followup-withdraw-approve"), { boundTo: { candidateSha: source, baseSha: candidateSha, intentVersion: 1 } });
        await life.withdrawApproval("followup-withdrawal", human, key("followup-withdraw-approval"), { ...state("landed"), approvalId: approved.body.id });
        await life.withdrawCandidate("followup-withdrawal", human, key("followup-withdraw-candidate"), { ...state("landed"), candidateId: follow.candidate.body.id });
        expect(await life.task("followup-withdrawal")).toMatchObject({ status: "landed", accepted_receipt_id: follow.receipt });
        await db.prepare("UPDATE target_refs SET known_head_sha=? WHERE repository_id='canonical'").bind(base).run();
        const ordinary = await submitted("ordinary-rejection");
        await refusal(life.rejectCandidate("ordinary-rejection", human, key("ordinary-reject"), { ...state("candidate"), candidateId: ordinary.candidate.body.id }), "use-task-reject");
    });
    it("retains delayed compute evidence without reviving a rejected task", async () => {
        await atStatus("late-compute", "submitted");
        const job = await life.one("SELECT * FROM lifecycle_outbox WHERE task_id='late-compute' AND kind='compute'");
        await life.closeTask("late-compute", human, key("late-compute-close"), { ...state("submitted"), outcome: "rejected" });
        const result = await life.candidate("late-compute", key("late-compute-result"), { runId: job.run_id,
            submissionId: JSON.parse(job.payload).submissionId, candidateSha, baseSha: base,
            candidateId: `candidate-${job.run_id}`, candidateRef: `refs/candidates/candidate-${job.run_id}`, checkIdentity: "none", checkPolicy: { mode: "none" } });
        expect((await life.task("late-compute")).status).toBe("rejected");
        expect(await life.one("SELECT status FROM candidates WHERE id=?", result.body.id)).toEqual({ status: "superseded" });
    });
});
