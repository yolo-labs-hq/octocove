import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reserveCanonicalRead } from "../src/canonical-head";
import { TokenBroker } from "../src/broker";
import { compute as integratorCompute, land as integratorLand } from "../../integrator/src/git.mjs";
import { agent, claimInput, create, db, human, key, life } from "./lifecycle-fixture";

// Two tasks on one canonical, landed and computed by the local native-Git integrator. A lands
// while a second canonical generation is reserved between A's fence and A's reconcile, so the
// receipt leaves the cached head unchanged and enqueues a head re-read. B's approval is bound to
// the base A just moved.
const ref = "refs/heads/main", repoId = "canonical";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let dir: string, canonical: string, work: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "octocove-stale-fence-"));
  canonical = join(dir, "canonical.git"); work = join(dir, "work");
  git(dir, "init", "--bare", canonical); git(dir, "init", "-b", "main", work);
  git(work, "config", "user.name", "Stale fence"); git(work, "config", "user.email", "stale@example.invalid");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

/** A fresh canonical main with one base commit, recorded as the known head. */
let n = 0;
beforeEach(async () => {
  writeFileSync(join(work, "base"), `base ${++n}\n`);
  git(work, "add", "."); git(work, "commit", "-m", `base ${n}`);
  const base = git(work, "rev-parse", "HEAD");
  git(work, "push", "--force", canonical, `${base}:${ref}`);
  await db.prepare("UPDATE target_refs SET known_head_sha=? WHERE repository_id=? AND ref_name=?").bind(base, repoId, ref).run();
});
const head = () => git(canonical, "rev-parse", ref);
const cached = async () => (await life.one("SELECT known_head_sha FROM target_refs WHERE repository_id=? AND ref_name=?", repoId, ref)).known_head_sha;
/** A squash of one new file on `base`, persisted at its candidate ref like a compute run. */
function squash(base: string, file: string, candidateId: string) {
  git(work, "checkout", "--detach", "-f", base);
  writeFileSync(join(work, file), `${file}\n`); git(work, "add", "."); git(work, "commit", "-m", file);
  const sha = git(work, "rev-parse", "HEAD");
  git(work, "push", canonical, `${sha}:refs/candidates/${candidateId}`);
  return sha;
}
/** A submitted task whose compute job is enqueued against the current cached head. */
async function submitted(id: string) {
  const base = head();
  await create(id);
  const claim = `claim-${id}`;
  await life.claim(id, key(claim), claimInput(claim));
  await life.provision(claim);
  const submission = await life.submit(id, agent, claim, key(`submit-${id}`), { sourceSha: base, baseSha: base, intentVersion: 1 });
  const job = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", id);
  return { id, claim, base, runId: job.run_id as string, submissionId: submission.body.id as string };
}
/** Record a compute result squashed on `base`, as the integrator would after fetching it. */
async function computed(s: Awaited<ReturnType<typeof submitted>>, base = s.base) {
  const candidateId = `candidate-${s.runId}`, candidateSha = squash(base, s.id, candidateId);
  const recorded = await life.candidate(s.id, key(`candidate-${s.id}`), {
    runId: s.runId, candidateId, submissionId: s.submissionId, candidateSha, baseSha: base,
    candidateRef: `refs/candidates/${candidateId}`, checkIdentity: "no-check", checkPolicy: { mode: "none" },
  });
  return { ...s, base, candidateId, candidateSha, status: recorded.body.status };
}
const approve = (id: string, candidateSha: string, baseSha: string, k = `approve-${id}`) =>
  life.approve(id, human, key(k), { boundTo: { candidateSha, baseSha, intentVersion: 1 } });
/** An approved candidate of a new task, computed against the current canonical head. */
async function approved(id: string) {
  const c = await computed(await submitted(id));
  const approval = await approve(id, c.candidateSha, c.base);
  return { ...c, approvalId: approval.body.id as string };
}
/** Run the integrator's CAS landing for a held fence and record its receipt. */
async function integrate(taskId: string, fenceId: string) {
  const f = await life.one("SELECT * FROM landing_fences WHERE id=?", fenceId);
  const job = { runId: f.integrator_run_id, candidateId: f.candidate_id, candidateSha: f.candidate_sha, baseSha: f.base_sha,
    intentVersion: f.intent_version, fenceId: f.id, approvalId: f.approval_id, repoId, targetRef: ref, canonicalUrl: canonical };
  const io = {
    authorizeLanding: async () => ({ ...job, held: (await life.one("SELECT status FROM landing_fences WHERE id=?", fenceId)).status === "held", checksPassed: true }),
    readTokens: async () => ({ canonical: "read-canonical" }),
    landWriteToken: async () => ({ token: "write", repo: repoId, targetRef: ref, refFamily: ref }),
    persistLanding: async (r: any) => life.reconcile(taskId, key(`reconcile-${fenceId}`), {
      repoId: r.repoId, targetRef: r.targetRef, fenceId, runId: r.runId, outcome: r.outcome, canonicalSha: r.baseShaAfter,
      landedSha: r.landedSha ?? undefined, ancestryVerified: r.ancestryVerified, writerTerminated: r.writerTerminated,
      eventIds: r.eventIdsConsumed, conflictFiles: r.conflictFiles ?? undefined, errorDetail: r.errorDetail ?? undefined,
    }),
  };
  return integratorLand(job, io);
}
/** Run the integrator's compute for an outbox job against the base its payload expects. */
async function runCompute(taskId: string, runId: string) {
  const payload = JSON.parse((await life.one("SELECT payload FROM lifecycle_outbox WHERE run_id=?", runId)).payload);
  const submission = await life.one("SELECT * FROM submissions WHERE id=?", payload.submissionId);
  const sourceRef = `refs/sources-fixture/${runId}`;
  git(work, "push", canonical, `${submission.source_sha}:${sourceRef}`);
  const job = { repoId, targetRef: ref, runId, candidateId: `candidate-${runId}`, submissionId: submission.id, sourceSha: submission.source_sha,
    sourceUrl: canonical, sourceRef, canonicalUrl: canonical, baseSha: payload.expectedBaseSha, createdAt: payload.createdAt, checkPolicy: { mode: "none" } };
  let status: string | undefined;
  const result = await integratorCompute(job, {
    readTokens: async () => ({ source: "read-source", canonical: "read-canonical" }),
    candidateWriteToken: async () => ({ token: "write", repo: repoId, targetRef: ref, refFamily: "refs/candidates/" }),
    persistCandidate: async (r: any) => {
      status = (await life.candidate(taskId, key(`candidate-${runId}`), { runId, submissionId: r.submissionId, candidateId: r.candidateId,
        outcome: r.outcome, candidateSha: r.candidateSha ?? undefined, baseSha: r.baseSha, candidateRef: r.candidateRef ?? undefined,
        checkIdentity: r.checkIdentity, checkPolicy: r.checkPolicy })).body.status;
    },
    runChecks: async () => ({ result: "skipped", evidence: {} }),
    persistCheck: async () => {},
  });
  return { ...result, status };
}
/** Deliver outbox work like the coordinators would; cross-task base-moves enter baseMoved. */
const coordinate = async (other: string, command: string, k: string, input: any) =>
  command === "baseMoved" ? life.baseMoved(other, k, input.headSha, true) : life.reevaluate(other, k);
const drain = (id: string, phase: "all" | "local" | "fanout" = "all") =>
  life.dispatch({ send: async () => {} }, id, coordinate, async () => head(), phase);
const computes = (id: string) =>
  life.rows("SELECT run_id,json_extract(payload,'$.expectedBaseSha') AS base FROM lifecycle_outbox WHERE task_id=? AND kind='compute' ORDER BY rowid", id);
/** A lands while a second canonical read is reserved, so its receipt is stale evidence. */
async function landWithStaleEvidence(a: Awaited<ReturnType<typeof approved>>) {
  const landing = await life.land(a.id, human, key(`land-${a.id}`), { approvalId: a.approvalId });
  expect(landing.status).toBe(202);
  await reserveCanonicalRead(db, repoId, ref);
  expect(await integrate(a.id, landing.body.fenceId)).toMatchObject({ outcome: "landed", landedSha: a.candidateSha });
  expect(head()).toBe(a.candidateSha);
  // The receipt deliberately leaves the cache at the old base and schedules a head re-read.
  expect(await cached()).toBe(a.base);
  expect(await life.one("SELECT COUNT(*) AS n FROM lifecycle_outbox WHERE task_id=? AND kind='base-move' AND json_extract(payload,'$.reconcileHead')=1 AND delivered_at IS NULL", a.id))
    .toEqual({ n: 1 });
  return landing.body.fenceId as string;
}
/** A fences, a generation-reserved read observes the unchanged base before A pushes, then A
 * lands: that observation follows A's fence, so A's reconcile is stale evidence. */
async function landAfterPrePushObservation(prefix: string) {
  const a = await approved(`${prefix}-a`), b = await approved(`${prefix}-b`);
  const landing = await life.land(a.id, human, key(`land-${a.id}`), { approvalId: a.approvalId });
  const generation = await reserveCanonicalRead(db, repoId, ref);
  await life.baseMoved(a.id, key(`observe-pre-push-${a.id}`), head(), false, generation);
  expect(await integrate(a.id, landing.body.fenceId)).toMatchObject({ outcome: "landed", landedSha: a.candidateSha });
  expect(await cached()).toBe(a.base);
  expect(b.base).toBe(a.base);
  return { a, b, receiptId: landing.body.fenceId as string };
}
/** A read reserved before A's fence applies after A pushes and an external writer restores the
 * base: fence acquisition does not advance the generation, so it applies at A's fence generation. */
async function landAfterRestoredPreFenceRead(prefix: string) {
  const a = await approved(`${prefix}-a`), b = await approved(`${prefix}-b`);
  const generation = await reserveCanonicalRead(db, repoId, ref);
  const fenced = await life.land(a.id, human, key(`land-${a.id}`), { approvalId: a.approvalId });
  expect(await life.one("SELECT generation FROM canonical_fences WHERE fence_id=?", fenced.body.fenceId)).toEqual({ generation });
  git(work, "push", canonical, `${a.candidateSha}:${ref}`);
  git(work, "push", "--force", canonical, `${a.base}:${ref}`);
  await life.baseMoved(a.id, key(`observe-pre-fence-${a.id}`), head(), false, generation);
  expect(await life.one("SELECT generation FROM canonical_head_observations WHERE repository_id=? AND ref_name=?", repoId, ref)).toEqual({ generation });
  await life.reconcile(a.id, key(`reconcile-pre-fence-${a.id}`), {
    repoId, targetRef: ref, fenceId: fenced.body.fenceId, runId: fenced.body.runId, outcome: "landed",
    canonicalSha: a.candidateSha, landedSha: a.candidateSha, ancestryVerified: true, writerTerminated: true, eventIds: [],
  });
  expect(await cached()).toBe(a.base);
  expect(b.base).toBe(a.base);
  return { a, b, receiptId: fenced.body.fenceId as string };
}
/** While A's receipt is ambiguous, B's land is refused without a write and may be retried. */
async function expectHeld(b: Awaited<ReturnType<typeof approved>>, receiptId: string) {
  const rereadRunId = (await life.one("SELECT run_id FROM lifecycle_outbox WHERE kind='base-move' AND json_extract(payload,'$.fenceId')=?", receiptId)).run_id;
  const before = await computes(b.id);
  for (let i = 0; i < 2; i++)
    await expect(life.land(b.id, human, key(`land-${b.id}`), { approvalId: b.approvalId }))
      .rejects.toMatchObject({ code: "stale-base", status: 409, details: { receiptId, pending: true, rereadRunId } });
  expect(await life.one("SELECT status,invalidation_reason FROM approvals WHERE id=?", b.approvalId))
    .toEqual({ status: "active", invalidation_reason: null });
  expect(await life.one("SELECT status FROM candidates WHERE id=?", b.candidateId)).toEqual({ status: "active" });
  expect(await life.rows("SELECT id FROM landing_fences WHERE task_id=?", b.id)).toEqual([]);
  expect(await life.rows("SELECT id FROM audit_log WHERE task_id=? AND type IN ('approval.invalidated','approval.fenced','landing.fenced')", b.id)).toEqual([]);
  expect(await life.rows("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind IN ('base-move','land')", b.id)).toEqual([]);
  expect(await computes(b.id)).toEqual(before);
}

describe("landing admission after a stale-evidence reconcile", () => {
  it("guards the fence batch against a receipt recorded after B's admission checks", async () => {
    const a = await approved("stale-fence-guard-a"), b = await approved("stale-fence-guard-b");
    const fenced = await life.land(a.id, human, key(`land-${a.id}`), { approvalId: a.approvalId });
    await reserveCanonicalRead(db, repoId, ref);
    // A's receipt commits between B's reads and B's fence batch; the cache stays stale.
    const original = (life as any).validCandidate;
    (life as any).validCandidate = async function (this: unknown, ...args: unknown[]) {
      await original.apply(this, args);
      (life as any).validCandidate = original;
      await integrate(a.id, fenced.body.fenceId);
    };
    try {
      await expect(life.land(b.id, human, key(`land-${b.id}`), { approvalId: b.approvalId }))
        .rejects.toMatchObject({ code: "operation-in-progress", status: 409 });
    } finally { (life as any).validCandidate = original; }
    expect(head()).toBe(a.candidateSha);
    expect(await life.one("SELECT known_head_sha FROM target_refs WHERE repository_id=? AND ref_name=?", repoId, ref))
      .toEqual({ known_head_sha: a.base });
    expect(await life.rows("SELECT id FROM landing_fences WHERE task_id=?", b.id)).toEqual([]);
    expect(await life.one("SELECT status FROM approvals WHERE id=?", b.approvalId)).toEqual({ status: "active" });
    // A retry is then refused up front, citing A's receipt.
    expect(await life.land(b.id, human, key(`land-retry-${b.id}`), { approvalId: b.approvalId }))
      .toEqual({ status: 409, body: { code: "stale-base", details: { receiptId: fenced.body.fenceId, headSha: a.candidateSha } } });
  }, 30_000);

  it("refuses B's obsolete approval up front with stale-base, then recomputes once on the re-read head", async () => {
    const a = await approved("stale-fence-refused-a"), b = await approved("stale-fence-refused-b");
    const receiptId = await landWithStaleEvidence(a);
    // The cache still names B's base; A's pending receipt moved canonical off exactly that base.
    await expect(approve(b.id, b.candidateSha, b.base, `approve-again-${b.id}`))
      .rejects.toMatchObject({ code: "stale-base", status: 409, details: { receiptId, headSha: a.candidateSha } });
    const before = await computes(b.id);
    const refused = await life.land(b.id, human, key(`land-${b.id}`), { approvalId: b.approvalId });
    expect(refused).toEqual({ status: 409, body: { code: "stale-base", details: { receiptId, headSha: a.candidateSha } } });
    expect(await life.land(b.id, human, key(`land-${b.id}`), { approvalId: b.approvalId })).toEqual(refused);
    expect(await life.one("SELECT status,invalidation_reason,invalidation_ref FROM approvals WHERE id=?", b.approvalId))
      .toEqual({ status: "invalidated", invalidation_reason: "base-move", invalidation_ref: receiptId });
    expect(await life.one("SELECT status,status_reason,status_ref FROM candidates WHERE id=?", b.candidateId))
      .toEqual({ status: "stale", status_reason: "base-move", status_ref: receiptId });
    expect(await life.one("SELECT status FROM tasks WHERE id=?", b.id)).toEqual({ status: "submitted" });
    expect(await life.rows("SELECT id FROM landing_fences WHERE task_id=?", b.id)).toEqual([]);
    expect(await life.rows("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='land'", b.id)).toEqual([]);
    expect(await life.rows("SELECT id FROM audit_log WHERE task_id=? AND type IN ('approval.fenced','landing.fenced','landing.dispatched')", b.id)).toEqual([]);
    expect(head()).toBe(a.candidateSha);
    // No compute is pinned to the rejected cached base; B's own head re-read is scheduled instead.
    expect(await computes(b.id)).toEqual(before);
    expect(await life.rows("SELECT json_extract(payload,'$.receiptId') AS receipt FROM lifecycle_outbox WHERE task_id=? AND kind='base-move' AND json_extract(payload,'$.reconcileHead')=1", b.id))
      .toEqual([{ receipt: receiptId }]);

    // A's cross-task notifications reach B while the cache still names the old base: nothing to recompute.
    await drain(a.id, "fanout");
    expect(await computes(b.id)).toEqual(before);
    // B's re-read validates the head by generation; A's own re-read and its fan-out then coalesce.
    await drain(b.id);
    expect(await cached()).toBe(a.candidateSha);
    for (const id of [a.id, b.id, a.id, b.id]) await drain(id);
    const after = await computes(b.id);
    expect(after).toEqual([...before, { run_id: expect.any(String), base: a.candidateSha }]);
    const rerun = after.at(-1)!.run_id;
    expect(await life.rows("SELECT id FROM audit_log WHERE task_id=? AND type='target_ref.head_observed' AND json_extract(refs,'$.computeRunId')=?", b.id, rerun))
      .toHaveLength(1);
    // The recompute runs against the new head and lands B.
    const recomputed = await runCompute(b.id, rerun);
    expect(recomputed).toMatchObject({ outcome: "computed", baseSha: a.candidateSha, status: "active" });
    const approval = await approve(b.id, recomputed.candidateSha, a.candidateSha, `approve-recomputed-${b.id}`);
    const landing = await life.land(b.id, human, key(`land-recomputed-${b.id}`), { approvalId: approval.body.id });
    expect(landing.status).toBe(202);
    expect(await integrate(b.id, landing.body.fenceId)).toMatchObject({ outcome: "landed", landedSha: recomputed.candidateSha });
    expect(head()).toBe(recomputed.candidateSha);
  }, 60_000);

  it("admits B's approval on a head observed after A's push when A's receipt is recorded late", async () => {
    const a = await approved("stale-fence-late-a");
    const fenced = await life.land(a.id, human, key(`land-${a.id}`), { approvalId: a.approvalId });
    // The integrator pushes A, then an external writer advances canonical before A's receipt is recorded.
    git(work, "push", canonical, `${a.candidateSha}:${ref}`);
    const external = squash(a.candidateSha, "external-late", "external-late");
    git(work, "push", canonical, `${external}:${ref}`);
    await life.baseMoved(a.id, key(`observe-external-${a.id}`), external);
    const b = await approved("stale-fence-late-b");
    expect(b.base).toBe(external);
    await life.reconcile(a.id, key(`reconcile-late-${a.id}`), {
      repoId, targetRef: ref, fenceId: fenced.body.fenceId, runId: fenced.body.runId, outcome: "landed",
      canonicalSha: a.candidateSha, landedSha: a.candidateSha, ancestryVerified: true, writerTerminated: true, eventIds: [],
    });
    // Stale evidence keeps the newer observed head; A's receipt does not contradict B's base.
    expect(await cached()).toBe(external);
    expect(await life.one("SELECT COUNT(*) AS n FROM lifecycle_outbox WHERE task_id=? AND kind='base-move' AND json_extract(payload,'$.reconcileHead')=1 AND delivered_at IS NULL", a.id))
      .toEqual({ n: 1 });
    const landing = await life.land(b.id, human, key(`land-${b.id}`), { approvalId: b.approvalId });
    expect(landing.status).toBe(202);
    expect(await integrate(b.id, landing.body.fenceId)).toMatchObject({ outcome: "landed", landedSha: b.candidateSha });
    expect(head()).toBe(b.candidateSha);
  }, 30_000);

  it("holds B's approval on a restored base observed before A's receipt, until a re-read reserved after it", async () => {
    const a = await approved("stale-fence-restored-a");
    const fenced = await life.land(a.id, human, key(`land-${a.id}`), { approvalId: a.approvalId });
    // The integrator pushes A, then an external writer restores the original base (A→B→A).
    git(work, "push", canonical, `${a.candidateSha}:${ref}`);
    git(work, "push", "--force", canonical, `${a.base}:${ref}`);
    // A fresh, generation-reserved read observes the restored base before A's receipt is recorded.
    const generation = await reserveCanonicalRead(db, repoId, ref);
    await life.baseMoved(a.id, key(`observe-restored-${a.id}`), head(), false, generation);
    const b = await approved("stale-fence-restored-b");
    expect(b.base).toBe(a.base);
    await life.reconcile(a.id, key(`reconcile-restored-${a.id}`), {
      repoId, targetRef: ref, fenceId: fenced.body.fenceId, runId: fenced.body.runId, outcome: "landed",
      canonicalSha: a.candidateSha, landedSha: a.candidateSha, ancestryVerified: true, writerTerminated: true, eventIds: [],
    });
    expect(await cached()).toBe(a.base);
    // Nothing orders that read after A's push, so it cannot decide; neither can the receipt.
    await drain(a.id, "fanout");
    await expectHeld(b, fenced.body.fenceId);
    // A's re-read, reserved after its reconcile, observes the restored base: B is admitted on it.
    await drain(a.id, "local");
    expect(await cached()).toBe(a.base);
    await drain(a.id, "fanout");
    const before = await computes(b.id);
    const landing = await life.land(b.id, human, key(`land-${b.id}`), { approvalId: b.approvalId });
    expect(landing.status).toBe(202);
    expect(await life.one("SELECT status,invalidation_reason FROM approvals WHERE id=?", b.approvalId))
      .toEqual({ status: "fenced", invalidation_reason: null });
    expect(await life.rows("SELECT id FROM audit_log WHERE task_id=? AND type='approval.invalidated'", b.id)).toEqual([]);
    expect(await life.rows("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='base-move' AND json_extract(payload,'$.reconcileHead')=1", b.id)).toEqual([]);
    expect(await computes(b.id)).toEqual(before);
    expect(await integrate(b.id, landing.body.fenceId)).toMatchObject({ outcome: "landed", landedSha: b.candidateSha });
    expect(head()).toBe(b.candidateSha);
  }, 30_000);

  it("holds B's approval when a read observed the base after A's fence but before A's push; A's re-read then refuses it", async () => {
    const { a, b, receiptId } = await landAfterPrePushObservation("stale-fence-pre-push");
    await expectHeld(b, receiptId);
    // A's re-read observes A's landing: B is refused on the validated head and its approval invalidated.
    await drain(a.id, "local");
    expect(await cached()).toBe(a.candidateSha);
    await expect(life.land(b.id, human, key(`land-after-reread-${b.id}`), { approvalId: b.approvalId }))
      .rejects.toMatchObject({ code: "stale-base", status: 409 });
    const before = await computes(b.id);
    await drain(a.id, "fanout");
    expect(await life.one("SELECT status,invalidation_reason,invalidation_ref FROM approvals WHERE id=?", b.approvalId))
      .toEqual({ status: "invalidated", invalidation_reason: "base-move", invalidation_ref: a.candidateSha });
    expect(await life.one("SELECT status FROM candidates WHERE id=?", b.candidateId)).toEqual({ status: "stale" });
    expect(await computes(b.id)).toEqual([...before, { run_id: expect.any(String), base: a.candidateSha }]);
    await expect(life.land(b.id, human, key(`land-invalidated-${b.id}`), { approvalId: b.approvalId }))
      .rejects.toMatchObject({ code: "approval-invalidated", status: 409 });
    expect(await life.rows("SELECT id FROM landing_fences WHERE task_id=?", b.id)).toEqual([]);
    expect(head()).toBe(a.candidateSha);
  }, 30_000);

  it("admits B's held approval once a re-read reserved after A's reconcile observes the base restored", async () => {
    const { a, b, receiptId } = await landAfterPrePushObservation("stale-fence-pre-push-restored");
    await expectHeld(b, receiptId);
    // An external writer restores the base before A's re-read reads canonical.
    git(work, "push", "--force", canonical, `${a.base}:${ref}`);
    await drain(a.id, "local");
    expect(await cached()).toBe(a.base);
    await drain(a.id, "fanout");
    const landing = await life.land(b.id, human, key(`land-${b.id}`), { approvalId: b.approvalId });
    expect(landing.status).toBe(202);
    expect(await life.rows("SELECT id FROM audit_log WHERE task_id=? AND type='approval.invalidated'", b.id)).toEqual([]);
    expect(await integrate(b.id, landing.body.fenceId)).toMatchObject({ outcome: "landed", landedSha: b.candidateSha });
    expect(head()).toBe(b.candidateSha);
  }, 30_000);

  it("holds B's approval on a restored base read reserved before A's fence, then admits it on a post-reconcile re-read of the base", async () => {
    const { a, b, receiptId } = await landAfterRestoredPreFenceRead("stale-fence-pre-fence-restored");
    await drain(a.id, "fanout");
    await expectHeld(b, receiptId);
    // A's re-read, reserved after its reconcile, still observes the restored base.
    await drain(a.id, "local");
    expect(await cached()).toBe(a.base);
    await drain(a.id, "fanout");
    const landing = await life.land(b.id, human, key(`land-${b.id}`), { approvalId: b.approvalId });
    expect(landing.status).toBe(202);
    expect(await life.rows("SELECT id FROM audit_log WHERE task_id=? AND type='approval.invalidated'", b.id)).toEqual([]);
    expect(await integrate(b.id, landing.body.fenceId)).toMatchObject({ outcome: "landed", landedSha: b.candidateSha });
    expect(head()).toBe(b.candidateSha);
  }, 30_000);

  it("holds B's approval on a restored base read reserved before A's fence, then refuses it on a post-reconcile re-read of A", async () => {
    const { a, b, receiptId } = await landAfterRestoredPreFenceRead("stale-fence-pre-fence-landed");
    await expectHeld(b, receiptId);
    // Canonical returns to A's landing before A's re-read reads it.
    git(work, "push", "--force", canonical, `${a.candidateSha}:${ref}`);
    await drain(a.id, "local");
    expect(await cached()).toBe(a.candidateSha);
    await expect(life.land(b.id, human, key(`land-after-reread-${b.id}`), { approvalId: b.approvalId }))
      .rejects.toMatchObject({ code: "stale-base", status: 409 });
    await drain(a.id, "fanout");
    expect(await life.one("SELECT status,invalidation_reason,invalidation_ref FROM approvals WHERE id=?", b.approvalId))
      .toEqual({ status: "invalidated", invalidation_reason: "base-move", invalidation_ref: a.candidateSha });
    expect(await life.rows("SELECT id FROM landing_fences WHERE task_id=?", b.id)).toEqual([]);
    expect(head()).toBe(a.candidateSha);
  }, 30_000);

  it("refuses a candidate on the old base recorded after A's receipt, and recomputes it once", async () => {
    // B's compute job (and its fetch) precede A's landing; its result is recorded after A's stale reconcile.
    const s = await submitted("stale-fence-delayed-b");
    const a = await approved("stale-fence-delayed-a");
    const receiptId = await landWithStaleEvidence(a);
    const b = await computed(s);
    expect(b).toMatchObject({ base: a.base, status: "active" });
    await expect(approve(b.id, b.candidateSha, b.base))
      .rejects.toMatchObject({ code: "stale-base", status: 409, details: { receiptId, headSha: a.candidateSha } });
    expect(await life.rows("SELECT id FROM approvals WHERE task_id=?", b.id)).toEqual([]);
    // A's re-read is the authority: its fan-out marks the candidate stale and recomputes on the new head once.
    for (const id of [a.id, a.id, b.id]) await drain(id);
    expect(await cached()).toBe(a.candidateSha);
    expect(await life.one("SELECT status FROM candidates WHERE id=?", b.candidateId)).toEqual({ status: "stale" });
    expect(await computes(b.id)).toEqual([{ run_id: s.runId, base: a.base }, { run_id: expect.any(String), base: a.candidateSha }]);
  }, 30_000);

  it("recomputes a refused staged follow-up of a landed task under its candidate-write authority", async () => {
    const f = await approved("stale-fence-follow-up");
    const fenced = await life.land(f.id, human, key(`land-${f.id}`), { approvalId: f.approvalId });
    // A revision staged behind F's fence becomes a follow-up attempt once F lands.
    git(work, "checkout", "--detach", "-f", f.base);
    writeFileSync(join(work, "revision"), "revision\n"); git(work, "add", "."); git(work, "commit", "-m", "revision");
    const revision = git(work, "rev-parse", "HEAD");
    await life.submit(f.id, agent, f.claim, key(`stage-${f.id}`), { sourceSha: revision, baseSha: f.base, intentVersion: 1 });
    expect(await integrate(f.id, fenced.body.fenceId)).toMatchObject({ outcome: "landed" });
    expect(await life.one("SELECT status FROM tasks WHERE id=?", f.id)).toEqual({ status: "landed" });
    const follow = (await computes(f.id)).at(-1)!;
    expect(follow.base).toBe(f.candidateSha);
    const first = await runCompute(f.id, follow.run_id);
    expect(first).toMatchObject({ outcome: "computed", status: "active" });
    const approval = await approve(f.id, first.candidateSha, f.candidateSha, `approve-follow-${f.id}`);
    // A lands from that same head with stale evidence; the follow-up's land is refused up front.
    const a = await approved("stale-fence-follow-up-a");
    const receiptId = await landWithStaleEvidence(a);
    const before = await computes(f.id);
    expect(await life.land(f.id, human, key(`land-follow-${f.id}`), { approvalId: approval.body.id }))
      .toEqual({ status: 409, body: { code: "stale-base", details: { receiptId, headSha: a.candidateSha } } });
    expect(await life.one("SELECT status,invalidation_reason FROM approvals WHERE id=?", approval.body.id))
      .toEqual({ status: "invalidated", invalidation_reason: "base-move" });
    for (const id of [f.id, a.id, f.id]) await drain(id);
    // Every compute scheduled from the refusal on: exactly one, on the re-read head.
    const rerun = (await computes(f.id)).slice(before.length);
    expect(rerun).toEqual([{ run_id: expect.any(String), base: a.candidateSha }]);
    // The broker authorizes the recompute's candidate write as the landed task's staged follow-up.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      if (options?.method !== "POST") return Response.json({ success: true, result: {} });
      const input = JSON.parse(options.body as string);
      return Response.json({ success: true, result: { id: crypto.randomUUID(), plaintext: "synthetic-token", scope: input.scope,
        expires_at: new Date((Math.floor(Date.now() / 1000) + input.ttl) * 1000).toISOString() } });
    });
    const management = Object.fromEntries([["ARTIFACTS_ACCOUNT_ID", "fixture"], ["ARTIFACTS_API_TOKEN", "fixture"]]);
    const broker = new TokenBroker({ DB: db, ...management } as any);
    await expect(broker.mintCandidateForJob(rerun[0].run_id, { repo: repoId, targetRef: ref })).resolves.toMatchObject({ refFamily: "refs/candidates/" });
    expect(await runCompute(f.id, rerun[0].run_id)).toMatchObject({ outcome: "computed", baseSha: a.candidateSha, status: "active" });
  }, 60_000);

  it("still resolves a fence admitted on a genuinely fresh cache but raced at CAS as raced", async () => {
    const b = await approved("stale-fence-fresh-cas");
    const landing = await life.land(b.id, human, key(`land-${b.id}`), { approvalId: b.approvalId });
    expect(landing.status).toBe(202);
    // Canonical moves after admission and before the integrator's push; no receipt records it.
    const other = squash(b.base, "external", "external-writer");
    git(work, "push", "--force", canonical, `${other}:${ref}`);
    expect(await integrate(b.id, landing.body.fenceId)).toMatchObject({ outcome: "raced", baseShaAfter: other });
    expect(await life.one("SELECT status,invalidation_reason,invalidation_ref FROM approvals WHERE id=?", b.approvalId))
      .toEqual({ status: "invalidated", invalidation_reason: "landing-raced", invalidation_ref: landing.body.fenceId });
    expect(await life.one("SELECT status FROM candidates WHERE id=?", b.candidateId)).toEqual({ status: "raced" });
    expect(await life.one("SELECT outcome,landed_sha,base_sha_after FROM landing_receipts WHERE fence_id=?", landing.body.fenceId))
      .toEqual({ outcome: "raced", landed_sha: null, base_sha_after: other });
    expect(head()).toBe(other);
  }, 30_000);
});
